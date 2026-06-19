export type TranslationStatus =
  | "none"
  | "translating"
  | "translated"
  | "partial"
  | "failed";

export interface DocMeta {
  id: string;
  title: string;
  source: string;
  addedAt: number;
  size: number;
  translationStatus: TranslationStatus;
}

export interface DocRecord extends DocMeta {
  /** Original-language HTML as downloaded/uploaded. */
  html: string;
  /** Simplified-Chinese translation, present once translationStatus === "translated". */
  htmlZh: string | null;
}

export interface AppUser {
  id: string;
  conductorUserId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  displayName: string;
  conductorBaseUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicUser {
  id: string;
  conductorUserId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  displayName: string;
}
