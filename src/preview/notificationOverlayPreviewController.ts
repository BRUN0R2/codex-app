import type { NotificationChannel } from "../contracts/notificationOverlay";
import type { NotificationOverlayController } from "../state/notificationOverlayController";

const COMMAND_APPROVAL = {
  id: "preview-approval",
  method: "approval.command",
  params: {
    threadId: "preview-thread",
    turnId: "preview-turn",
    itemId: "preview-item",
    command: "pnpm verify",
    cwd: "D:\\Workspaces\\codex-app",
    reason: "Executar a validação completa antes de concluir a tarefa.",
  },
} as const;

export function createNotificationOverlayPreviewController(
  channel: NotificationChannel,
): NotificationOverlayController {
  const notification =
    channel === "priority"
      ? ({
          id: "approval-required:preview-approval",
          event: "approvalRequired",
          tone: "attention",
          title: "Uma tarefa precisa da sua aprovação",
          message: "Revise a ação pendente antes que o trabalho continue.",
          createdAt: 1_800_000_000_000,
          approval: COMMAND_APPROVAL,
          presentation: { type: "priority" },
          target: { type: "thread", threadId: "preview-thread" },
        } as const)
      : ({
          id: "luna-reserve-preview",
          event: "lunaReserveAvailable",
          tone: "attention",
          title: "Luna Reserve está disponível",
          message: "O modelo reserva já pode ser selecionado.",
          createdAt: 1_800_000_000_000,
          approval: null,
          presentation: { type: "transient", durationSeconds: 30, position: "bottomRight" },
          target: null,
        } as const);
  return {
    notification: () => notification,
    pendingCount: () => 1,
    approvalResponseFailed: () => false,
    approvalResponding: () => false,
    activate: () => undefined,
    dismiss: () => undefined,
    respondToApproval: () => undefined,
    startDrag: () => undefined,
    synchronizePresentation: () => undefined,
  };
}
