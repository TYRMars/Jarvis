/** A parsed JSON value. Tool arguments and JSON-schema parameters use this. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
