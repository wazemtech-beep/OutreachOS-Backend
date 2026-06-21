import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "user@outreachos.local" },
    update: {},
    create: {
      email: "user@outreachos.local",
      name: "Waseem",
      passwordHash: "local-mode",
      timezone: "Asia/Karachi",
      currency: "USD",
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: "default" },
    update: {},
    create: {
      name: "OutreachOS",
      slug: "default",
      userId: user.id,
    },
  });

  console.log("Seeded:", { userId: user.id, workspaceId: workspace.id });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
