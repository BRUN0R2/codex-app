import { createEffect, createSignal, Show } from "solid-js";

import type { ChatGptAccount } from "../contracts/types";

interface AccountAvatarProps {
  readonly account: ChatGptAccount | null | undefined;
  readonly size?: "compact" | "profile" | "settings";
}

export function AccountAvatar(props: AccountAvatarProps) {
  let observedAccount = props.account;
  const [failedPicture, setFailedPicture] = createSignal<string | null>(null);
  createEffect(() => {
    const currentAccount = props.account;
    if (currentAccount === observedAccount) {
      return;
    }
    observedAccount = currentAccount;
    setFailedPicture(null);
  });
  const picture = () => {
    const source = props.account?.picture ?? null;
    return source !== failedPicture() ? source : null;
  };

  return (
    <span aria-hidden="true" class={`account-avatar account-avatar-${props.size ?? "compact"}`}>
      <span>{accountInitials(props.account)}</span>
      <Show when={picture()}>
        {(source) => (
          <img
            alt=""
            decoding="async"
            onError={() => setFailedPicture(source())}
            referrerpolicy="no-referrer"
            src={source()}
          />
        )}
      </Show>
    </span>
  );
}

export function accountDisplayName(account: ChatGptAccount | null | undefined): string {
  const name = account?.name?.trim();
  if (name !== undefined && name.length > 0) {
    return name;
  }
  const emailName = account?.email?.split("@", 1)[0]?.trim();
  return emailName !== undefined && emailName.length > 0 ? emailName : "Conta ChatGPT";
}

function accountInitials(account: ChatGptAccount | null | undefined): string {
  const words = accountDisplayName(account)
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const initials =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}` : words[0]?.[0];
  return (initials ?? "C").toLocaleUpperCase("pt-BR");
}
