import React from "react";
import { num } from "../shared";
// Contador de caracteres de un campo de texto con mínimo y máximo. Se enlaza al
// campo con aria-describedby.
export function Counter(p: {
  id: string;
  length: number;
  min: number;
  max: number;
}) {
  const short = p.length < p.min,
    over = p.length > p.max;
  return (
    <small id={p.id} className={"counter num" + (short || over ? " off" : "")}>
      {num(p.length, 0)} / {num(p.max, 0)}
      {short ? ` · mínimo ${num(p.min, 0)}` : ""}
      {over ? ` · sobran ${num(p.length - p.max, 0)}` : ""}
    </small>
  );
}
// Número de cada versión por orden de creación, empezando en 1.
export const versionNumbers = (versions: { id: string }[]) =>
  new Map(versions.map((v, i) => [v.id, i + 1]));
