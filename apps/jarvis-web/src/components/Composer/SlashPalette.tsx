// Floating "/" command palette anchored above the composer. Visible
// only when the composer value starts with "/", and the prefix
// matches at least one command. Arrow keys navigate, Enter/Tab
// selects, Esc closes (handled by the parent Composer).

import { t } from "../../utils/i18n";

export interface SlashCommand {
  cmd: string;
  descKey: string;
  run?: () => void;
  insertText?: string;
}

interface Props {
  open: boolean;
  commands: SlashCommand[];
  index: number;
  onHover: (i: number) => void;
  onPick: (cmd: SlashCommand) => void;
}

export function SlashPalette({ open, commands, index, onHover, onPick }: Props) {
  return (
    <div className={"slash-palette" + (open ? "" : " hidden")} id="slash-palette">
      {commands.map((c, i) => (
        <div
          key={c.cmd}
          className={"slash-row" + (i === index ? " active" : "")}
          onClick={(e) => { e.stopPropagation(); onPick(c); }}
          onMouseEnter={() => onHover(i)}
        >
          <div className="slash-cmd">{c.cmd}</div>
          <div className="slash-desc">{t(c.descKey)}</div>
        </div>
      ))}
    </div>
  );
}
