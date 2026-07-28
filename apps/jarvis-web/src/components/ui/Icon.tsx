import type { LucideIcon, LucideProps } from "lucide-react";

export type IconProps = Omit<LucideProps, "ref"> & {
  icon: LucideIcon;
};

export function Icon({
  icon: IconComponent,
  size = 17,
  strokeWidth = 1.9,
  ...props
}: IconProps) {
  return (
    <IconComponent
      aria-hidden="true"
      focusable="false"
      size={size}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
}

export {
  ArrowLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Ban,
  Blocks,
  Bot,
  Brain,
  Cable,
  Check,
  ChevronDown,
  CircleAlert,
  CirclePlus,
  ClipboardList,
  Clock,
  CodeXml,
  Database,
  Diff,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Files,
  GitBranch,
  Image,
  KeyRound,
  LayoutDashboard,
  Link2,
  List,
  ListChecks,
  ListFilter,
  ListTodo,
  MemoryStick,
  MessageSquareMore,
  Mic,
  Network,
  PanelLeft,
  PanelLeftOpen,
  PanelRight,
  Palette,
  Pencil,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  SquarePen,
  Star,
  Square,
  SquareTerminal,
  Tags,
  Trash2,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
