import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToNotificationOverlaySurface } from "./notificationOverlayClient";
import {
  emitBrowserPreviewRuntimeEvent,
  installBrowserPreviewRuntime,
  resetBrowserPreviewRuntime,
} from "./runtimeBridge";

afterEach(resetBrowserPreviewRuntime);

describe("notification overlay client", () => {
  it("delivers presentation and approval events only to their owning channel", async () => {
    installBrowserPreviewRuntime(() => null);
    const priorityPresentation = vi.fn();
    const priorityApprovalResult = vi.fn();
    const transientPresentation = vi.fn();
    const transientApprovalResult = vi.fn();
    const onBoundaryError = vi.fn();
    const disposePriority = await subscribeToNotificationOverlaySurface(
      "priority",
      priorityPresentation,
      priorityApprovalResult,
      onBoundaryError,
    );
    const disposeTransient = await subscribeToNotificationOverlaySurface(
      "transient",
      transientPresentation,
      transientApprovalResult,
      onBoundaryError,
    );
    const transientPayload = {
      channel: "transient",
      notification: null,
      pendingCount: 0,
    } as const;
    const priorityResult = {
      channel: "priority",
      notificationId: "approval-required:approval-1",
      requestId: "approval-1",
      succeeded: true,
    } as const;

    expect(
      emitBrowserPreviewRuntimeEvent(
        "notification-overlay:transient:presentation",
        transientPayload,
      ),
    ).toBe(true);
    expect(
      emitBrowserPreviewRuntimeEvent(
        "notification-overlay:priority:approval-result",
        priorityResult,
      ),
    ).toBe(true);
    expect(
      emitBrowserPreviewRuntimeEvent("notification-overlay:presentation", transientPayload),
    ).toBe(false);

    expect(transientPresentation).toHaveBeenCalledOnce();
    expect(transientPresentation).toHaveBeenCalledWith(transientPayload);
    expect(priorityPresentation).not.toHaveBeenCalled();
    expect(priorityApprovalResult).toHaveBeenCalledOnce();
    expect(priorityApprovalResult).toHaveBeenCalledWith(priorityResult);
    expect(transientApprovalResult).not.toHaveBeenCalled();
    expect(onBoundaryError).not.toHaveBeenCalled();

    disposePriority();
    disposeTransient();
  });
});
