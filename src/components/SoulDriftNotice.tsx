import { t } from "@/lib/i18n";

export function SoulDriftNotice({ drift, onReview }: { drift?: boolean; onReview: () => void }) {
  if (!drift) return null;
  return (
    <div role="status" data-soul-drift-notice className="mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-ink">
      <span className="min-w-0 flex-1">{t("chat.soulDriftNotice")}</span>
      <button type="button" onClick={onReview} className="ui-button ui-button-sm shrink-0">
        {t("chat.soulDriftReview")}
      </button>
    </div>
  );
}
