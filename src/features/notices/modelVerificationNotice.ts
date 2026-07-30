import type {
  ModelVerification,
  ModelVerificationNotification,
} from "../../shared/codex/types";

const TRUSTED_ACCESS_FOR_CYBER_WARNING =
  "Suas conversas têm várias sinalizações de possível risco de cibersegurança. "
  + "As respostas podem demorar mais porque verificações adicionais de segurança estão ativas. "
  + "Para obter autorização para trabalho de segurança, participe do programa Trusted Access for Cyber: "
  + "https://chatgpt.com/cyber";

export function modelVerificationWarnings(
  notification: ModelVerificationNotification,
): string[] {
  return [...new Set(notification.verifications)].map(verificationWarning);
}

function verificationWarning(verification: ModelVerification): string {
  switch (verification) {
    case "trustedAccessForCyber":
      return TRUSTED_ACCESS_FOR_CYBER_WARNING;
  }
}
