export declare const makeManifest: (input: {
  version: string;
  pubDate: string;
  base: string;
  files: string[];
  sigs: Record<string, string>;
}) => {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};
