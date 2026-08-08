import { Show } from "solid-js";

import type { ChatGptAccount } from "../contracts/types";

interface AccountAvatarProps {
  readonly account: ChatGptAccount | null | undefined;
  readonly large?: boolean;
}

export function AccountAvatar(props: AccountAvatarProps) {
  return (
    <span aria-hidden="true" class="account-avatar" classList={{ large: props.large === true }}>
      <span>{accountInitials(props.account)}</span>
      <Show when={props.account?.picture}>
        {(picture) => (
          <img
            alt=""
            decoding="async"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
            onLoad={(event) => {
              event.currentTarget.hidden = false;
            }}
            referrerpolicy="no-referrer"
            src={picture()}
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
