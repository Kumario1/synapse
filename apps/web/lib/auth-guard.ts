export interface GuardSession {
  user?: {
    id?: string | null;
  } | null;
}

export class AuthenticationRequired extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthenticationRequired";
  }
}

export function requireUser(session: GuardSession | null | undefined): { userId: string } {
  const userId = session?.user?.id;
  if (!userId) {
    throw new AuthenticationRequired();
  }
  return { userId };
}
