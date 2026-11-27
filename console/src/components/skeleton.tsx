/** Squelettes : la forme de la page pendant la lecture, sans valeur inventée. */

export function NasHeaderSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3.5">
      <div className="h-4 w-40 animate-pulse rounded bg-surface-2" />
      <div className="h-8 w-64 animate-pulse rounded bg-surface-2" />
      <div className="h-4 w-80 animate-pulse rounded bg-surface-2" />
      <div className="h-[42px] border-border border-b" />
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card h-[150px] animate-pulse" />
        ))}
      </div>
      <div className="card h-[280px] animate-pulse" />
    </div>
  );
}

/** La synthèse d'un NAS : la carte du verdict, la même en bref et en détail, puis les tuiles. */
export function OverviewSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <div className="card h-[116px] animate-pulse" />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="card h-[118px] animate-pulse" />
        ))}
      </div>
    </div>
  );
}
