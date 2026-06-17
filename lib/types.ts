export interface DocMeta {
  id: string;
  title: string;
  source: string;
  addedAt: number;
  size: number;
}

export interface DocRecord extends DocMeta {
  html: string;
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
