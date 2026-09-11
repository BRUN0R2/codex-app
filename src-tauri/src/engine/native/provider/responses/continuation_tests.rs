use super::*;

fn image_message(detail: ImageDetail, image_bytes: usize) -> ResponseItem {
    ResponseItem::user_content_with_id(
        "image-input",
        vec![
            ResponseContent::InputText {
                text: "Inspect this image.".into(),
            },
            ResponseContent::InputImage {
                image_url: format!("data:image/png;base64,{}", "x".repeat(image_bytes)),
                detail: Some(detail),
            },
        ],
    )
}

fn request(input: &[ResponseItem], protocol: ResponseProtocol) -> ResponseRequest<'_> {
    ResponseRequest::new(
        "gpt-test",
        "Keep reasoning and image content intact.",
        &[],
        input,
        &[],
        ResponseRequestSettings {
            protocol,
            prompt_cache_key: Some("image-thread"),
            ..Default::default()
        },
    )
    .expect("request should build")
}

fn completed() -> CompletedWebSocketResponse {
    CompletedWebSocketResponse {
        response_id: "response-image".into(),
        output_items: Vec::new(),
    }
}

#[test]
fn lite_image_details_match_the_wire_without_mutating_canonical_history() {
    let history = [image_message(ImageDetail::Original, 64)];
    for protocol in [ResponseProtocol::Standard, ResponseProtocol::Lite] {
        let first = request(&history, protocol);
        let baseline = first.to_owned_baseline().expect("baseline should build");
        let changed_detail = [image_message(ImageDetail::Low, 64)];
        let next = request(&changed_detail, protocol);
        assert_eq!(
            next.continuation_input_start(&baseline, &completed())
                .is_some(),
            protocol == ResponseProtocol::Lite,
        );
        let changed_image = [image_message(ImageDetail::Original, 65)];
        assert!(
            request(&changed_image, protocol)
                .continuation_input_start(&baseline, &completed())
                .is_none()
        );
    }
    assert!(matches!(&history[0], ResponseItem::Message { content, .. }
        if matches!(content[1], ResponseContent::InputImage { detail: Some(ImageDetail::Original), .. })));
}

#[test]
fn lite_tool_image_continuations_preserve_text_audio_and_call_identity() {
    let original = ResponseItem::function_output_payload(
        "call-image".into(),
        FunctionCallOutputPayload::Content(vec![
            FunctionCallOutputContent::InputText {
                text: "Image result".into(),
            },
            FunctionCallOutputContent::InputImage {
                image_url: "data:image/png;base64,aA==".into(),
                detail: Some(ImageDetail::Original),
            },
            FunctionCallOutputContent::InputAudio {
                audio_url: "data:audio/wav;base64,aA==".into(),
            },
        ]),
    );
    let history = [original.clone()];
    let first = request(&history, ResponseProtocol::Lite);
    let baseline = first.to_owned_baseline().expect("baseline should build");
    assert!(
        first
            .continuation_input_start(&baseline, &completed())
            .is_some()
    );
    for mutation in 0..4 {
        let mut changed = original.clone();
        let ResponseItem::FunctionCallOutput {
            call_id,
            output: FunctionCallOutputPayload::Content(content),
            ..
        } = &mut changed
        else {
            panic!("fixture is a multimodal tool output");
        };
        match mutation {
            0 => *call_id = "another-call".into(),
            1 => {
                content[0] = FunctionCallOutputContent::InputText {
                    text: "Changed result".into(),
                }
            }
            2 => {
                content[1] = FunctionCallOutputContent::InputImage {
                    image_url: "data:image/png;base64,bA==".into(),
                    detail: None,
                }
            }
            _ => {
                content[2] = FunctionCallOutputContent::InputAudio {
                    audio_url: "data:audio/wav;base64,bA==".into(),
                }
            }
        }
        assert!(
            request(&[changed], ResponseProtocol::Lite)
                .continuation_input_start(&baseline, &completed())
                .is_none()
        );
    }
}

#[test]
fn code_mode_custom_image_outputs_follow_the_same_lite_projection_as_function_outputs() {
    let output = FunctionCallOutputPayload::Content(vec![
        FunctionCallOutputContent::InputText {
            text: "Screenshot result".into(),
        },
        FunctionCallOutputContent::InputImage {
            image_url: "data:image/png;base64,aA==".into(),
            detail: Some(ImageDetail::Original),
        },
    ]);
    for item in [
        ResponseItem::function_output_payload("call-image".into(), output.clone()),
        ResponseItem::custom_output_payload("call-image".into(), output),
    ] {
        let history = [item];
        for protocol in [ResponseProtocol::Standard, ResponseProtocol::Lite] {
            let request = request(&history, protocol);
            let encoded = serde_json::to_value(&request).expect("request should encode");
            let index = if protocol == ResponseProtocol::Lite {
                2
            } else {
                0
            };
            let image = &encoded["input"][index]["output"][1];
            assert_eq!(image["image_url"], "data:image/png;base64,aA==");
            assert_eq!(
                image.get("detail").is_none(),
                protocol == ResponseProtocol::Lite
            );
            let baseline = request.to_owned_baseline().expect("baseline should build");
            assert!(
                request
                    .continuation_input_start(&baseline, &completed())
                    .is_some()
            );
        }
        assert_eq!(
            serde_json::to_value(&history[0]).expect("canonical item should encode")["output"][1]["detail"],
            "original"
        );
    }
}

#[test]
#[ignore = "performance benchmark; run through `pnpm measure:multimodal-continuation`"]
fn benchmark_multimodal_continuation() {
    use std::hint::black_box;
    use std::time::Instant;

    const IMAGE_BYTES: usize = 3 * 1_024 * 1_024;
    const SAMPLES: usize = 40;
    let history = [image_message(ImageDetail::Original, IMAGE_BYTES)];
    let first = request(&history, ResponseProtocol::Lite);
    let baselines: Vec<_> = (0..SAMPLES)
        .map(|_| first.to_owned_baseline().expect("baseline should build"))
        .collect();
    let next_history = [
        history[0].clone(),
        ResponseItem::user_content_with_id(
            "followup",
            vec![ResponseContent::InputText {
                text: "Continue.".into(),
            }],
        ),
    ];
    let next = request(&next_history, ResponseProtocol::Lite);
    let started = Instant::now();
    let results: Vec<_> = baselines
        .into_iter()
        .map(|baseline| {
            black_box(
                next.prepare_websocket_request(
                    Some(baseline),
                    Some(completed()),
                    "image-thread",
                    None,
                )
                .expect("multimodal continuation should prepare"),
            )
        })
        .collect();
    let elapsed = started.elapsed();
    let normalized = history[0].for_request(true).into_owned();
    let copied_started = Instant::now();
    for _ in 0..SAMPLES {
        assert!(
            black_box(history[0].for_request(true))
                .equivalent_for_continuation(black_box(&normalized), false)
        );
    }
    let copied_elapsed = copied_started.elapsed();
    let borrowed_started = Instant::now();
    for _ in 0..SAMPLES {
        assert!(black_box(&history[0]).equivalent_for_continuation(black_box(&normalized), true));
    }
    let borrowed_elapsed = borrowed_started.elapsed();
    let comparison_speedup = copied_elapsed.as_secs_f64() / borrowed_elapsed.as_secs_f64();
    assert!(
        comparison_speedup > 1.25,
        "multimodal continuation must avoid normalizing a fresh image copy: {comparison_speedup:.3}x"
    );
    for result in &results {
        let payload: Value = serde_json::from_str(&result.payload).expect("request is JSON");
        assert_eq!(payload["previous_response_id"], "response-image");
        assert_eq!(
            payload["input"]
                .as_array()
                .expect("input is an array")
                .len(),
            1
        );
        assert!(result.payload.len() < 1_024);
    }
    println!(
        "multimodal_continuation image_bytes={IMAGE_BYTES} samples={SAMPLES} total_ms={:.3} per_request_ms={:.3} payload_bytes={} copied_comparison_ms={:.3} borrowed_comparison_ms={:.3} comparison_speedup={comparison_speedup:.3}x",
        elapsed.as_secs_f64() * 1_000.0,
        elapsed.as_secs_f64() * 1_000.0 / SAMPLES as f64,
        results[0].payload.len(),
        copied_elapsed.as_secs_f64() * 1_000.0,
        borrowed_elapsed.as_secs_f64() * 1_000.0,
    );
}
