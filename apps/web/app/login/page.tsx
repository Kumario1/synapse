import { redirect } from "next/navigation";
import { auth, signIn } from "../../auth";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/dashboard");
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">Website Account</p>
        <h1>Log in to Synapse</h1>
        <p>Use GitHub to save self-hosted server connections for this dashboard.</p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/dashboard" });
          }}
        >
          <button type="submit">Continue with GitHub</button>
        </form>
      </section>
    </main>
  );
}
