const gitRevision = Bun.env.RELEASE_GIT_SHA;
if (gitRevision === undefined || !/^[0-9a-f]{40}$/u.test(gitRevision)) {
  throw new Error("RELEASE_GIT_SHA must be a full lowercase Git revision");
}
await Bun.write(
  new URL("../dist/deployment-metadata.json", import.meta.url),
  `${JSON.stringify({ gitRevision })}\n`
);
