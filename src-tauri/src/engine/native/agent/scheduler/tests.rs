use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{Notify, Semaphore, mpsc, watch};
use tokio::time::timeout;

use super::{MAX_PARALLEL_TOOLS, MAX_TOOLS_PER_RESPONSE, ToolScheduler};
use crate::engine::native::provider::{ResponseItem, normalize_provider_history};
use crate::error::AppError;

#[tokio::test]
async fn tools_start_before_response_completion_and_survive_a_stream_failure() {
    let mut scheduler = ToolScheduler::new();
    let started = Arc::new(Notify::new());
    let executions = Arc::new(AtomicUsize::new(0));
    let signal = Arc::clone(&started);
    let count = Arc::clone(&executions);
    scheduler
        .enqueue(false, async move {
            count.fetch_add(1, Ordering::SeqCst);
            signal.notify_one();
            tokio::time::sleep(Duration::from_millis(10)).await;
            ResponseItem::function_output("call-1".into(), "saved once".into())
        })
        .expect("call should be admitted");

    let stream_result: Result<(), AppError> = timeout(
        Duration::from_secs(1),
        scheduler.next_response_event(async {
            started.notified().await;
            Err(AppError::Transport(
                "connection interrupted after the call".into(),
            ))
        }),
    )
    .await
    .expect("tool must start without waiting for the response to end");
    assert!(stream_result.is_err());
    let drained = scheduler.drain().await;
    assert!(drained.failure.is_none());
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    let mut history = vec![ResponseItem::FunctionCall {
        id: Some("item-1".into()),
        namespace: None,
        name: "write_file".into(),
        arguments: "{}".into(),
        call_id: "call-1".into(),
    }];
    history.extend(drained.results);
    let normalized =
        normalize_provider_history(history).expect("retry history should remain valid");
    assert!(
        !normalized.changed(),
        "a completed call must not become an aborted call on retry"
    );
    assert_eq!(normalized.items.len(), 2);
}

#[tokio::test]
async fn parallel_admission_is_bounded_and_mutations_keep_fifo_barriers() {
    let mut scheduler = ToolScheduler::new();
    let gate = Arc::new(Semaphore::new(0));
    let (entered, mut entries) = mpsc::unbounded_channel();
    for index in 0..MAX_PARALLEL_TOOLS + 3 {
        let gate = Arc::clone(&gate);
        let entered = entered.clone();
        let parallel = index != MAX_PARALLEL_TOOLS + 1;
        scheduler
            .enqueue(parallel, async move {
                entered.send(index).expect("observer should stay alive");
                gate.acquire()
                    .await
                    .expect("gate should remain open")
                    .forget();
                index
            })
            .expect("call should be admitted");
    }
    for _ in 0..MAX_PARALLEL_TOOLS {
        timeout(Duration::from_secs(1), entries.recv())
            .await
            .expect("first readers should overlap");
    }
    assert!(
        entries.try_recv().is_err(),
        "the ninth operation must wait for capacity"
    );
    gate.add_permits(1);
    scheduler.advance().await;
    assert_eq!(
        timeout(Duration::from_secs(1), entries.recv())
            .await
            .expect("next reader should start"),
        Some(MAX_PARALLEL_TOOLS)
    );
    assert!(
        entries.try_recv().is_err(),
        "mutation must wait for all earlier readers"
    );
    gate.add_permits(MAX_PARALLEL_TOOLS);
    for _ in 0..MAX_PARALLEL_TOOLS {
        scheduler.advance().await;
    }
    assert_eq!(entries.recv().await, Some(MAX_PARALLEL_TOOLS + 1));
    assert!(
        entries.try_recv().is_err(),
        "later reads must not cross the mutation"
    );
    gate.add_permits(1);
    scheduler.advance().await;
    assert_eq!(entries.recv().await, Some(MAX_PARALLEL_TOOLS + 2));
    gate.add_permits(1);
    let drained = scheduler.drain().await;
    assert!(drained.failure.is_none());
    assert_eq!(
        drained.results,
        (0..MAX_PARALLEL_TOOLS + 3).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn reverse_completions_are_drained_in_provider_call_order() {
    let mut scheduler = ToolScheduler::new();
    let mut gates = Vec::new();
    for index in 0..MAX_PARALLEL_TOOLS {
        let gate = Arc::new(Notify::new());
        gates.push(Arc::clone(&gate));
        scheduler
            .enqueue(true, async move {
                gate.notified().await;
                index
            })
            .expect("call should be admitted");
    }
    for gate in gates.iter().rev() {
        gate.notify_one();
        scheduler.advance().await;
    }
    let drained = scheduler.drain().await;
    assert!(drained.failure.is_none());
    assert_eq!(drained.results, (0..MAX_PARALLEL_TOOLS).collect::<Vec<_>>());
}

#[tokio::test]
async fn cancellation_drains_running_and_queued_calls_without_orphan_tasks() {
    let mut scheduler = ToolScheduler::new();
    let (cancel, cancellation) = watch::channel(false);
    let settled = Arc::new(AtomicUsize::new(0));
    for index in 0..MAX_PARALLEL_TOOLS * 3 {
        let mut cancellation = cancellation.clone();
        let settled = Arc::clone(&settled);
        scheduler
            .enqueue(index % 3 != 0, async move {
                if !*cancellation.borrow() {
                    cancellation
                        .changed()
                        .await
                        .expect("turn should be interrupted");
                }
                settled.fetch_add(1, Ordering::SeqCst);
                index
            })
            .expect("call should be admitted");
    }
    cancel
        .send(true)
        .expect("cancellation receivers should exist");
    let drained = timeout(Duration::from_secs(1), scheduler.drain())
        .await
        .expect("cancellation must drain promptly");
    assert!(drained.failure.is_none());
    assert_eq!(settled.load(Ordering::SeqCst), MAX_PARALLEL_TOOLS * 3);
    assert_eq!(drained.results.len(), MAX_PARALLEL_TOOLS * 3);
}

#[tokio::test]
async fn response_admission_is_bounded_and_does_not_accumulate_across_rounds() {
    for round in 0..100 {
        let mut scheduler = ToolScheduler::new();
        assert!(!scheduler.has_calls());
        for index in 0..MAX_TOOLS_PER_RESPONSE {
            scheduler
                .enqueue(true, async move { (round, index) })
                .expect("bounded call should fit");
        }
        assert!(
            scheduler
                .enqueue(true, async { (usize::MAX, usize::MAX) })
                .is_err()
        );
        let drained = scheduler.drain().await;
        assert!(drained.failure.is_none());
        assert_eq!(drained.results.len(), MAX_TOOLS_PER_RESPONSE);
        assert_eq!(
            drained.results.last(),
            Some(&(round, MAX_TOOLS_PER_RESPONSE - 1))
        );
    }
}

#[tokio::test]
async fn servicing_tools_does_not_restart_the_pending_stream_read() {
    let mut scheduler = ToolScheduler::new();
    let polls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&polls);
    for _ in 0..MAX_TOOLS_PER_RESPONSE {
        scheduler.enqueue(true, async {}).expect("call should fit");
    }
    scheduler
        .next_response_event(async move {
            count.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
        })
        .await;
    assert_eq!(polls.load(Ordering::SeqCst), 1);
    assert_eq!(
        scheduler.drain().await.results.len(),
        MAX_TOOLS_PER_RESPONSE
    );
}

#[tokio::test]
#[ignore = "synthetic response/tool overlap benchmark"]
async fn benchmark_streamed_tool_dispatch() {
    let response_tail = Duration::from_millis(100);
    let tool_time = Duration::from_millis(100);
    let mut deferred = Duration::ZERO;
    let mut streamed = Duration::ZERO;
    for _ in 0..5 {
        let started = Instant::now();
        tokio::time::sleep(response_tail).await;
        tokio::time::sleep(tool_time).await;
        deferred += started.elapsed();
        let started = Instant::now();
        let mut scheduler = ToolScheduler::new();
        scheduler
            .enqueue(false, async move { tokio::time::sleep(tool_time).await })
            .expect("call should fit");
        scheduler
            .next_response_event(tokio::time::sleep(response_tail))
            .await;
        let drained = scheduler.drain().await;
        assert!(drained.failure.is_none());
        streamed += started.elapsed();
    }
    println!(
        "streamed_tool_dispatch deferred_ms={} streamed_ms={} speedup={:.2}",
        deferred.as_millis(),
        streamed.as_millis(),
        deferred.as_secs_f64() / streamed.as_secs_f64()
    );
    assert!(
        streamed < deferred.mul_f64(0.8),
        "streaming should overlap the controlled response tail and tool work"
    );
}
