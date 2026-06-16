import NextAuth, { type DefaultSession } from "next-auth";
import GitHub from "next-auth/providers/github";

declare module "next-auth" {
  interface Session {
    user?: DefaultSession["user"] & {
      id?: string;
    };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  callbacks: {
    jwt({ token, profile }) {
      const websiteToken = token as typeof token & { userId?: string };
      if (profile?.id) {
        websiteToken.userId = String(profile.id);
      }
      return websiteToken;
    },
    session({ session, token }) {
      const websiteToken = token as typeof token & { userId?: string };
      session.user = {
        ...session.user,
        id: websiteToken.userId ?? ""
      };
      return session;
    }
  }
});
