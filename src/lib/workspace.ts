import prisma from "./db.js";

export async function getOrCreateDefaultWorkspace() {
  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({
      data: { email: "user@outreachos.local", name: "User", passwordHash: "local" },
    });
  }

  let workspace = await prisma.workspace.findFirst({ where: { userId: user.id } });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: { name: "My Workspace", slug: "default", userId: user.id },
    });
  }

  return { user, workspace };
}
