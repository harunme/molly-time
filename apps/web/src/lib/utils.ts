import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach class merging the names from the shared Tailwind theme. Values stay in CSS.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ["control", "control-sm", "control-lg", "button", "toast", "tab-indicator", "card-padding", "card-gap", "heatmap-cell", "heatmap-gap"],
      radius: ["ui", "control-mark", "card", "popover", "dialog", "heatmap"],
      blur: ["dialog"],
      text: ["ui", "loading", "caption", "display", "metric", "tiny", "footnote"],
      shadow: ["card", "popover", "dialog", "alert-dialog", "toast", "tooltip", "thumb", "primary-inset"],
    },
  },
});
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
