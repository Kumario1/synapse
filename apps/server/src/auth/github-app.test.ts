import assert from "node:assert/strict";
import test from "node:test";
import { buildInstallUrl, listInstallationReposForUser } from "./github-app.js";

test("buildInstallUrl points at the App's install page with the signed state", () => {
  const url = buildInstallUrl("my-app", "st");
  assert.ok(url.includes("/apps/my-app/installations/new"), url);
  assert.ok(url.includes("state=st"), url);
});

test("listInstallationReposForUser maps full_name + push permission", async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        repositories: [
          { full_name: "o/r1", permissions: { push: true } },
          { full_name: "o/r2", permissions: { push: false } }
        ]
      }),
      { status: 200 }
    )) as typeof fetch;
  const repos = await listInstallationReposForUser("1", "utok", fetchFn);
  assert.deepEqual(repos, [
    { fullName: "o/r1", pushAccess: true },
    { fullName: "o/r2", pushAccess: false }
  ]);
});

test("listInstallationReposForUser defaults pushAccess to false and skips nameless entries", async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        repositories: [{ full_name: "o/r1" }, { permissions: { push: true } }]
      }),
      { status: 200 }
    )) as typeof fetch;
  const repos = await listInstallationReposForUser("1", "utok", fetchFn);
  assert.deepEqual(repos, [{ fullName: "o/r1", pushAccess: false }]);
});

test("listInstallationReposForUser rejects on a non-2xx response", async () => {
  const fetchFn = (async () => new Response("nope", { status: 403 })) as typeof fetch;
  await assert.rejects(() => listInstallationReposForUser("1", "utok", fetchFn));
});
