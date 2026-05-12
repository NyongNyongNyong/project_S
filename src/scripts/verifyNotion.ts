import { verifyStorageAccess } from "../storage";

async function main() {
  const info = await verifyStorageAccess();
  console.log("Markdown storage verified.");
  console.log(`storiesDir: ${info.storiesDir}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`Markdown storage verification failed: ${message}`);
  process.exitCode = 1;
});
