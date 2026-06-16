import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { AuthenticationRequired, requireUser } from "../../lib/auth-guard";
import ConnectionDashboard from "./ConnectionDashboard";

export default async function DashboardPage() {
  const session = await auth();
  let userId: string;
  try {
    userId = requireUser(session).userId;
  } catch (error) {
    if (error instanceof AuthenticationRequired) {
      redirect("/login");
    }
    throw error;
  }

  return <ConnectionDashboard userId={userId} />;
}
