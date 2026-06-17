import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { fetchMe, signOut, type Owner } from "@/auth";

/**
 * Auth-aware topbar control (plan 051). Asks `/auth/me` on mount: signed-in
 * shows the Owner login (+ avatar) and a sign-out button; otherwise a Sign up
 * button that starts the GitHub flow at `/auth/github`. This is the ONLY place
 * the `/auth/github` link lives.
 */
export default function TopbarAuth() {
  const [owner, setOwner] = useState<Owner | null>(null);

  useEffect(() => {
    fetchMe()
      .then(setOwner)
      .catch(() => setOwner(null));
  }, []);

  if (owner) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {owner.avatarUrl ? (
            <Avatar size="sm">
              <AvatarImage src={owner.avatarUrl} alt={`@${owner.login}`} />
              <AvatarFallback>{owner.login.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
          ) : null}
          @{owner.login}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await signOut();
            window.location.reload();
          }}
        >
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <Button asChild size="sm">
      <a href="/auth/github">Sign up</a>
    </Button>
  );
}
