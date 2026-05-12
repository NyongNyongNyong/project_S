import { ensureStorageSchema, verifyStorageAccess } from "../storage";

async function main() {
  const verifyInfo = await verifyStorageAccess();
  const result = await ensureStorageSchema();

  console.log("Markdown storage bootstrap completed.");
  console.log(`storiesDir: ${verifyInfo.storiesDir}`);
  if (result.changedProperties.length === 0) {
    console.log("No storage changes were needed.");
  } else {
    console.log(`Applied steps: ${result.changedProperties.join(", ")}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`Markdown storage bootstrap failed: ${message}`);
  process.exitCode = 1;
});
