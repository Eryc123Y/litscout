import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";

export type Density = "auto" | "compact" | "summaries";
const densityKey = "litscout:list-density";
/** The reader's choice of row density; "auto" follows the day's size. */
export function readDensity(): Density {
  try {
    const stored = localStorage.getItem(densityKey);
    return stored === "compact" || stored === "summaries" ? stored : "auto";
  } catch {
    return "auto";
  }
}
export function saveDensity(value: Density) {
  try {
    localStorage.setItem(densityKey, value);
  } catch {
    /* The choice then lasts for this visit only. */
  }
}

/** Compact rows (title and one line) or rows with their summaries. */
export function DensityToggle({
  compact,
  onChange,
}: {
  compact: boolean;
  onChange: (value: "compact" | "summaries") => void;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label="Row density"
      className="ml-auto shrink-0 gap-0.5 rounded-md bg-control p-0.5"
      value={compact ? "compact" : "summaries"}
      onValueChange={(value) => {
        if (value === "compact" || value === "summaries") onChange(value);
      }}
    >
      <ToggleGroupItem value="compact" size="sm" className="px-2.5 text-xs">
        Compact
      </ToggleGroupItem>
      <ToggleGroupItem value="summaries" size="sm" className="px-2.5 text-xs">
        Summaries
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
