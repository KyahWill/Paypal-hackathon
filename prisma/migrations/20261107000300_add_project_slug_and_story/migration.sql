-- Added nullable and backfilled, so this also applies to an already seeded
-- database. A demo reset then gives the seed's real slug and story.
ALTER TABLE "Project" ADD COLUMN "slug" TEXT;
ALTER TABLE "Project" ADD COLUMN "story" TEXT;

UPDATE "Project" SET "slug" = "id", "story" = "purpose";

ALTER TABLE "Project" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "Project" ALTER COLUMN "story" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
