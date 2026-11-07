import styles from "./page.module.css";

export default function ProjectNotFound() {
  return (
    <div className={styles.page}>
      <p className={styles.loading}>
        We could not find this project. Please check the link and try again.
      </p>
    </div>
  );
}
