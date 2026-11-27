import { cn } from "@/lib/format";

export function Card({
  children,
  className,
  labelledBy,
  as: Tag = "section",
}: {
  children: React.ReactNode;
  className?: string;
  labelledBy?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag className={cn("card", className)} aria-labelledby={labelledBy}>
      {children}
    </Tag>
  );
}

/** En-tête de carte : titre, précision discrète, action à droite. */
export function CardHeader({
  id,
  title,
  meta,
  action,
}: {
  id?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="card-h">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="h2" id={id}>
          {title}
        </h2>
        {meta ? <span className="meta">{meta}</span> : null}
      </div>
      {action}
    </div>
  );
}
