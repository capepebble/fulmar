/** Un champ de formulaire : son libellé au-dessus, son aide en dessous. */
export function Field({
  label,
  hint,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-medium text-[13px] text-fg-2">{label}</span>
      <input className="field" {...input} />
      {hint ? <span className="meta">{hint}</span> : null}
    </label>
  );
}
