// React wrapper around the existing imperative `renderEditDiff`.
// Same DOM result as before — we just mount it inside a ref'd div
// instead of the legacy module appending it directly. Reusing the
// imperative builder keeps the diff logic in one place.

import { useEffect, useRef } from "react";
import { renderEditDiff } from "../../diff_render";
import { el } from "../../utils/dom";
import { t } from "../../utils/i18n";

interface Props {
  args: { path?: string; old_string?: string; new_string?: string; replace_all?: boolean };
}

export function FsEditDiff({ args }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";
    ref.current.appendChild(renderEditDiff(args, el, t));
  }, [args]);
  return <div ref={ref} className="fs-edit-mount" />;
}
