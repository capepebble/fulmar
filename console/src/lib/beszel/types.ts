// Formes des réponses de Beszel (hub 0.21.2, PocketBase), relevées le 2026-11-21 sur le hub
// d'essai. Tout champ peut manquer : rien n'est supposé.
//
// Relevé dans le code de Beszel 0.21.2 :
// - `d`, `du` (et ceux de `efs`) sont en Go binaires (octets / 1 073 741 824) ;
// - `b` vaut [envoyé, reçu] en octets par seconde, toutes interfaces comprises ;
// - paliers des relevés : 1m, 10m, 20m, 120m, 480m (chacun fait la moyenne du précédent).

export type Tier = "1m" | "10m" | "20m" | "120m" | "480m";

export interface BzSystemInfo {
  /** Processeur, en %. */
  cpu?: number;
  /** Mémoire, en %. */
  mp?: number;
  /** Disque, en %. */
  dp?: number;
  /** Température la plus haute, en °C. */
  dt?: number;
  /** Durée de fonctionnement, en secondes. */
  u?: number;
  /** Charge moyenne sur 1, 5 et 15 min. */
  la?: number[];
  /** Réseau, en octets par seconde. */
  bb?: number;
  /** Version de l'agent Beszel. */
  v?: string;
}

export interface BzSystem {
  id: string;
  name: string;
  status?: "up" | "down" | "paused" | "pending";
  updated?: string;
  info?: BzSystemInfo;
}

export interface BzStats {
  cpu?: number;
  /** Mémoire utilisée, en %. */
  mp?: number;
  /** Mémoire totale et utilisée, en Go binaires. */
  m?: number;
  mu?: number;
  /** Disque principal : taille et occupation en Go binaires, occupation en %. */
  d?: number;
  du?: number;
  dp?: number;
  /** Températures par capteur, en °C. */
  t?: Record<string, number>;
  /** Réseau [envoyé, reçu], en octets par seconde. */
  b?: number[];
  /** Par interface : [envoyé/s, reçu/s, total envoyé, total reçu]. */
  ni?: Record<string, number[]>;
  /** Autres systèmes de fichiers, par nom. */
  efs?: Record<string, { d?: number; du?: number }>;
}

export interface BzStatsRecord {
  system: string;
  created: string;
  type: string;
  stats: BzStats;
}

export interface BzSmart {
  system: string;
  name: string;
  type?: string;
  model?: string;
  state?: string;
  temp?: number;
  hours?: number;
  capacity?: number;
  updated?: string;
}

export interface BzDetails {
  system: string;
  cpu?: string;
  cores?: number;
  threads?: number;
  memory?: number;
  kernel?: string;
  arch?: string;
}

export interface BzContainerRecord {
  created: string;
  stats: { n: string; c?: number; m?: number; u?: boolean }[];
}

export interface BzPage<T> {
  page?: number;
  totalPages?: number;
  items?: T[];
}
