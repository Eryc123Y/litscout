import { useTopicColour } from "./useTopicColour";

/** A topic as a coloured dot and a muted name: the colour marks identity,
 * the text stays in the text colour. */
export function TopicLabel({
  topic,
  topics,
}: {
  topic: string;
  topics: string[];
}) {
  const colourRef = useTopicColour(Math.max(0, topics.indexOf(topic)));
  return (
    <span
      ref={colourRef}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        data-slot="topic-dot"
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-topic"
      />
      {topic}
    </span>
  );
}
