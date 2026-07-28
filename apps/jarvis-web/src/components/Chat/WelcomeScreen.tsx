// First-render placeholder for an empty chat (no active conversation
// yet). Replaced by a real `<MessageList>` populated as soon as the
// user starts a conversation. Plain JSX, no store subscriptions —
// the parent decides when to mount us.

import { t } from "../../utils/i18n";

function tx(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

export function WelcomeScreen() {
  return (
    <div className="welcome">
      <div className="welcome-copy">
        <h1>{tx("welcomeCodexTitle", "我们应该在 Jarvis 中构建什么？")}</h1>
      </div>
    </div>
  );
}
