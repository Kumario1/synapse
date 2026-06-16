import { auth } from "../../../../auth";
import { deleteConnection, getConnection, updateConnection } from "../../../../lib/connection-api";
import { getConnectionStore } from "../../../../lib/connection-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return getConnection(request, {
    id,
    session: await auth(),
    store: getConnectionStore()
  });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return updateConnection(request, {
    id,
    session: await auth(),
    store: getConnectionStore()
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return deleteConnection(request, {
    id,
    session: await auth(),
    store: getConnectionStore()
  });
}
