import type { AccountPlanType } from "../contracts/types";

export function accountPlanName(planType: AccountPlanType | null): string {
  switch (planType) {
    case "free":
      return "Grátis";
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "prolite":
      return "Pro Lite";
    case "team":
      return "Team";
    case "business":
      return "Business";
    case "edu":
      return "Education";
    case "ent26":
    case "enterprise":
      return "Enterprise";
    case "enterprise_cbp_usage_based":
      return "Enterprise por créditos";
    case "self_serve_business_prolite":
      return "Business Pro Lite";
    case "self_serve_business_usage_based":
      return "Business por créditos";
    case null:
      return "ChatGPT";
  }
}

export function accountPlanLabel(planType: AccountPlanType | null): string {
  return `Plano ${accountPlanName(planType)}`;
}
