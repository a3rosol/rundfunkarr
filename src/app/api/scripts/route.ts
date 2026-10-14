import { NextResponse } from "next/server";
import { listPostProcessScripts, resolveScriptsDirectory } from "@/server/post-process";

/**
 * GET /api/scripts - List executable post-processing scripts
 */
export async function GET() {
  try {
    const directory = resolveScriptsDirectory();
    return NextResponse.json({ directory, scripts: await listPostProcessScripts(directory) });
  } catch (error) {
    console.error("Failed to list scripts:", error);
    return NextResponse.json({ error: "Failed to list scripts" }, { status: 500 });
  }
}
