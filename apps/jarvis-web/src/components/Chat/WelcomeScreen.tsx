// First-render placeholder for an empty chat (no active conversation
// yet). Replaced by a real `<MessageList>` populated as soon as the
// user starts a conversation. Plain JSX, no store subscriptions —
// the parent decides when to mount us.

import { t } from "../../utils/i18n";

export function WelcomeScreen() {
  return (
    <div className="welcome">
      <h1>{t("welcomeTitle")}</h1>
      <p>{t("welcomeBody")}</p>
    </div>
  );
}
