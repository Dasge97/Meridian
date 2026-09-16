// Tabla comparativa: una fila por métrica y una columna por simulación.
import React from "react";
import { Check } from "lucide-react";
import { pct } from "../shared";
import {
  riskLabel,
  signedMoney,
  whole,
  share,
  tokensPerOrder,
  SimKey,
  type CompareResponse,
  type SimComparison,
} from "./compare-parts";

type Row = {
  label: string;
  // Qué fila se marca como mejor: más o menos. Sin better no se marca, porque
  // más órdenes o más esperas no son mejores ni peores por sí mismas.
  better?: "more" | "less";
  value: (x: SimComparison) => number | null;
  show: (x: SimComparison) => React.ReactNode;
  sub?: (x: SimComparison) => React.ReactNode;
};

const venta = (v: SimComparison["trades"]["largestGain"]) =>
  v
    ? `${v.symbol} · ${new Date(v.at).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}`
    : null;

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Resultado",
    rows: [
      {
        label: "Resultado del periodo",
        better: "more",
        value: (x) => x.result.usd,
        show: (x) => signedMoney(x.result.usd),
        sub: (x) => pct(x.result.pct),
      },
      {
        label: "Ventas con beneficio",
        better: "more",
        value: (x) => x.trades.winRate,
        show: (x) =>
          x.trades.winRate === null
            ? "—"
            : `${whole(x.trades.winningSells)} / ${whole(x.trades.pricedSells)}`,
        sub: (x) =>
          x.trades.winRate === null
            ? "sin ventas medibles"
            : share(x.trades.winningSells, x.trades.pricedSells),
      },
      {
        label: "Mayor ganancia",
        value: (x) => x.trades.largestGain?.realizedPl ?? null,
        show: (x) => signedMoney(x.trades.largestGain?.realizedPl),
        sub: (x) => venta(x.trades.largestGain),
      },
      {
        label: "Mayor pérdida",
        value: (x) => x.trades.largestLoss?.realizedPl ?? null,
        show: (x) => signedMoney(x.trades.largestLoss?.realizedPl),
        sub: (x) => venta(x.trades.largestLoss),
      },
    ],
  },
  {
    title: "Órdenes ejecutadas",
    rows: [
      {
        label: "Órdenes ejecutadas",
        value: (x) => x.trades.orders,
        show: (x) => whole(x.trades.orders),
      },
      {
        label: "Compras",
        value: (x) => x.trades.buys,
        show: (x) => whole(x.trades.buys),
      },
      {
        label: "Ventas",
        value: (x) => x.trades.sells,
        show: (x) => whole(x.trades.sells),
      },
    ],
  },
  {
    title: "Decisiones",
    rows: [
      {
        label: "Decisiones",
        value: (x) => x.decisions.decisions,
        show: (x) => whole(x.decisions.decisions),
      },
      {
        label: "Esperas",
        value: (x) => x.decisions.waits,
        show: (x) => whole(x.decisions.waits),
        sub: (x) =>
          share(x.decisions.waits, x.decisions.decisions) +
          " de las decisiones",
      },
      {
        label: "Bloqueadas",
        value: (x) => x.decisions.blocked,
        show: (x) => whole(x.decisions.blocked),
      },
      {
        label: "Enviadas",
        value: (x) => x.decisions.sent,
        show: (x) => whole(x.decisions.sent),
      },
    ],
  },
  {
    title: "Modelo",
    rows: [
      {
        label: "Llamadas",
        value: (x) => x.tokens.calls,
        show: (x) => whole(x.tokens.calls),
      },
      {
        label: "Llamadas fallidas",
        better: "less",
        value: (x) => (x.tokens.calls ? x.tokens.failed : null),
        show: (x) => whole(x.tokens.failed),
      },
      {
        label: "Tokens",
        value: (x) => x.tokens.tokens,
        show: (x) => whole(x.tokens.tokens),
      },
      {
        label: "Tokens por llamada",
        better: "less",
        value: (x) => (x.tokens.calls ? x.tokens.avgPerCall : null),
        show: (x) => (x.tokens.calls ? whole(x.tokens.avgPerCall) : "—"),
      },
      {
        label: "Tokens por día",
        value: (x) => x.tokens.avgPerDay,
        show: (x) => whole(x.tokens.avgPerDay),
      },
      {
        label: "Tokens por orden ejecutada",
        better: "less",
        value: tokensPerOrder,
        show: (x) => whole(tokensPerOrder(x)),
        sub: (x) => (x.trades.orders ? null : "sin órdenes"),
      },
    ],
  },
];

// La mejor de la fila, si hay una sola y todas tienen valor.
function bestOf(row: Row, sims: SimComparison[]) {
  if (!row.better || sims.length < 2) return -1;
  const values = sims.map(row.value);
  if (values.some((v) => v === null)) return -1;
  const target = (row.better === "more" ? Math.max : Math.min)(
    ...(values as number[]),
  );
  const hits = values.filter((v) => v === target).length;
  return hits === 1 ? values.indexOf(target) : -1;
}

export function CompareTable({ data }: { data: CompareResponse }) {
  const sims = data.sims.map((id) => data.bySim[id]);
  return (
    <>
      <div className="cmp-table-wrap">
        <table className="cmp-table">
          <caption className="sr-only">
            Métricas de cada simulación en el periodo
          </caption>
          <colgroup>
            <col className="cmp-col-label" />
            {data.sims.map((id) => (
              <col key={id} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Métrica</th>
              {data.sims.map((id, i) => (
                <th scope="col" key={id}>
                  <span className="cmp-th-sim">
                    <SimKey id={id} index={i} />
                    <span>
                      {data.bySim[id].label}
                      <small>{riskLabel(data.bySim[id].riskProfile)}</small>
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {GROUPS.map((g) => (
            <tbody key={g.title}>
              <tr className="cmp-group">
                <th scope="colgroup" colSpan={sims.length + 1}>
                  {g.title}
                </th>
              </tr>
              {g.rows.map((row) => {
                const best = bestOf(row, sims);
                return (
                  <tr key={row.label}>
                    <th scope="row">
                      {row.label}
                      {row.better && (
                        <small>
                          {row.better === "more"
                            ? "más es mejor"
                            : "menos es mejor"}
                        </small>
                      )}
                    </th>
                    {sims.map((x, i) => {
                      const sub = row.sub?.(x);
                      return (
                        <td
                          key={data.sims[i]}
                          className={i === best ? "cmp-win" : undefined}
                        >
                          <span className="cmp-cell">
                            <span className="num cmp-value">
                              {i === best && (
                                <span className="cmp-win-mark">
                                  <Check size={13} aria-hidden />
                                  <span className="sr-only">Mejor: </span>
                                </span>
                              )}
                              <span>{row.show(x)}</span>
                            </span>
                            {sub && <small className="num">{sub}</small>}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
      <p className="cmp-table-note">
        <span className="cmp-win-mark" aria-hidden="true">
          <Check size={13} />
        </span>
        marca la mejor de la fila cuando tiene sentido: más resultado, más
        ventas con beneficio, menos fallos y menos tokens. Las demás filas no
        son mejores ni peores por sí mismas.
      </p>
    </>
  );
}
