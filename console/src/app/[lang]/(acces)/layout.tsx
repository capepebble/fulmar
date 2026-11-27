import { Logo } from "@/components/shell/logo";

// Les pages d'accès (bienvenue, connexion, installation) : sans barre latérale ni palette, un
// seul geste par écran.
export default function AccessLayout({ children }: LayoutProps<"/[lang]">) {
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 pt-[12vh] pb-16">
      <div className="flex w-full max-w-[420px] flex-col gap-7">
        <Logo className="h-7 w-auto self-start text-fg" />
        {children}
      </div>
    </main>
  );
}
