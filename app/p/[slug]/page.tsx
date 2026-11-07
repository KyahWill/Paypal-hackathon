import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { prisma } from "@/lib/db";
import {
  getProjectProgress,
  MAX_DONATION_MINOR,
  MIN_DONATION_MINOR,
} from "@/lib/donations";
import { formatMoney } from "@/lib/money";
import { DonationPanel } from "./donation-panel";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Give to this project",
  description: "Give through PayPal. Every peso is reimbursed against a real receipt.",
};

export default function ProjectPage({ params }: PageProps<"/p/[slug]">) {
  return (
    <div className={styles.page}>
      <Suspense fallback={<p className={styles.loading}>Opening the project...</p>}>
        <Project params={params} />
      </Suspense>
      <footer className={styles.footer}>
        This is a demo running on the PayPal sandbox. No real money moves.
      </footer>
    </div>
  );
}

async function Project({ params }: { params: PageProps<"/p/[slug]">["params"] }) {
  // Per request: the progress bar has to be right the moment a gift lands.
  await connection();
  const { slug } = await params;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { charity: { select: { name: true } } },
  });
  if (!project) notFound();

  const progress = await getProjectProgress(project.id);

  return (
    <main className={styles.layout}>
      <header className={styles.header}>
        <p className={styles.charity}>{project.charity.name}</p>
        <h1 className={styles.title}>{project.title}</h1>
      </header>

      <div className={styles.panel}>
        <DonationPanel
          slug={project.slug}
          currency={project.currency}
          initialProgress={progress}
          minMinor={MIN_DONATION_MINOR}
          maxMinor={MAX_DONATION_MINOR}
        />
      </div>

      <div className={styles.details}>
        <section className={styles.section}>
          <h2>Our story</h2>
          {project.story.split("\n\n").map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>

        <section className={styles.section}>
          <h2>What your gift pays for</h2>
          <p>{project.purpose}</p>
        </section>

        <section className={styles.section}>
          <h2>Recent gifts</h2>
          {progress.recent.length === 0 ? (
            <p>Be the first to give to this project.</p>
          ) : (
            <ul className={styles.gifts}>
              {progress.recent.map((gift) => (
                <li key={gift.id}>
                  <span>{gift.name}</span>
                  <span>{formatMoney(gift.amountMinor, progress.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
