import { auth } from "../../../auth";
import { createConnection, listConnections } from "../../../lib/connection-api";
import { getConnectionStore } from "../../../lib/connection-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return listConnections(request, {
    session: await auth(),
    store: getConnectionStore()
  });
}

export async function POST(request: Request) {
  return createConnection(request, {
    session: await auth(),
    store: getConnectionStore()
  });
}
