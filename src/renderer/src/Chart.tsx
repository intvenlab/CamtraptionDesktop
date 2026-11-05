// Thin React wrapper around uPlot for the Graphs tab: time on x, one line (or bar set) per Series,
// themed to the dark palette and resized with its container.

import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { Series, alignSeries } from '../../shared/series'

/** Blue-range series colours (cyan to violet) so lines stay distinguishable without leaving the theme. */
export const SERIES_COLORS = [
  '#3d8bfd', '#4fc3f7', '#9fa8ff', '#26c6da', '#64b5f6', '#b39ddb', '#00acc1', '#81d4fa', '#7986cb', '#4dd0e1',
  '#5aa2ff', '#ce93d8'
]

const AXIS = { stroke: '#7f9cc4', grid: { stroke: '#232933', width: 1 }, ticks: { stroke: '#2a303a', width: 1 } }

export interface ChartLine {
  series: Series
  label: string
  color: string
  dashed?: boolean
}

/** Whole-number tick steps, for counts. */
const INT_INCRS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000]

export default function Chart(props: {
  lines: ChartLine[]
  unit: string
  height?: number
  decimals?: number
  /** Time axis span in ms; defaults to the data's own span. */
  xRange?: [number, number]
}) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const height = props.height ?? 240

  useEffect(() => {
    const el = host.current
    if (!el) return
    const { x, ys } = alignSeries(props.lines.map((l) => l.series))
    const bars = uPlot.paths.bars!({ size: [0.6, 24], align: 1 })
    const dec = props.decimals ?? 0
    const xr = props.xRange
    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height,
      cursor: { drag: { x: true, y: false }, points: { size: 6 } },
      legend: { live: true },
      scales: { x: { time: true, ...(xr ? { range: [xr[0] / 1000, xr[1] / 1000] as uPlot.Range.MinMax } : {}) } },
      axes: [
        { ...AXIS },
        {
          ...AXIS,
          size: 56,
          ...(dec === 0 ? { incrs: INT_INCRS } : {}),
          values: (_u, vals) => vals.map((v) => (v == null ? '' : `${v.toFixed(dec)}`))
        }
      ],
      series: [
        { label: 'Time' },
        ...props.lines.map((l) => ({
          label: l.label,
          stroke: l.color,
          width: 1.75,
          dash: l.dashed ? [6, 4] : undefined,
          fill: l.series.bars ? l.color + '99' : undefined,
          paths: l.series.bars ? bars : undefined,
          points: { show: l.series.bars ? false : x.length < 60, size: 4 },
          spanGaps: true,
          value: (_u: uPlot, v: number | null) => (v == null ? '–' : `${v.toFixed(dec)} ${props.unit}`)
        }))
      ]
    }
    const u = new uPlot(opts, [x, ...ys] as uPlot.AlignedData, el)
    plot.current = u
    // Resize on the next frame: resizing inside the observer callback triggers "ResizeObserver loop" warnings.
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => u.setSize({ width: Math.max(200, el.clientWidth), height }))
    })
    ro.observe(el)
    return () => { cancelAnimationFrame(frame); ro.disconnect(); u.destroy(); plot.current = null }
  }, [props.lines, props.unit, props.decimals, height, props.xRange?.[0], props.xRange?.[1]])

  return <div ref={host} className="chart-host" />
}
