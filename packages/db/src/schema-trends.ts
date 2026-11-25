import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// The migration uses WITHOUT ROWID, so each upsert touches just one B-tree.
export const monthlyTrends = sqliteTable(
  "monthly_trends",
  {
    topic: text("topic").notNull(),
    month: text("month").notNull(),
    volume: integer("volume").notNull(),
    shortlisted: integer("shortlisted").notNull(),
    pickCount: integer("pick_count").notNull(),
    radarHits: integer("radar_hits").notNull(),
    radar: text("radar").notNull(),
    saveCount: integer("save_count").notNull(),
    ratingCount: integer("rating_count").notNull(),
    activityCount: integer("activity_count").notNull(),
    recurring: text("recurring").notNull(),
    rising: text("rising").notNull(),
    picks: text("picks").notNull(),
    activity: text("activity").notNull(),
  },
  (t) => [primaryKey({ columns: [t.topic, t.month] })],
);
