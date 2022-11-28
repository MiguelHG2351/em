import _ from 'lodash'
import React, { useState } from 'react'
import { useSelector } from 'react-redux'
import Index from '../@types/IndexType'
import LazyEnv from '../@types/LazyEnv'
import SimplePath from '../@types/SimplePath'
import State from '../@types/State'
import Thought from '../@types/Thought'
import ThoughtId from '../@types/ThoughtId'
import { isTouch } from '../browser'
import { HOME_PATH } from '../constants'
import globals from '../globals'
import findDescendant from '../selectors/findDescendant'
import { childrenFilterPredicate, getAllChildrenSorted, hasChildren } from '../selectors/getChildren'
import getStyle from '../selectors/getStyle'
import nextSibling from '../selectors/nextSibling'
import viewportStore from '../stores/viewport'
import { appendToPathMemo } from '../util/appendToPath'
import hashPath from '../util/hashPath'
import head from '../util/head'
import isRoot from '../util/isRoot'
import parseLet from '../util/parseLet'
import { safeRefMerge } from '../util/safeRefMerge'
import unroot from '../util/unroot'
import DropEnd from './DropEnd'
import VirtualThought from './VirtualThought'

type TreeThought = {
  depth: number
  env?: LazyEnv
  // index among visible siblings at the same level
  indexChild: number
  // index among all visible thoughts in the tree
  indexDescendant: number
  leaf: boolean
  simplePath: SimplePath
  // style inherited from parents with =children/=style and grandparents with =grandchildren/=style
  style?: React.CSSProperties | null
  thought: Thought
}

// style properties that accumulate down the hierarchy.
// We need to accmulate positioning like marginLeft so that all descendants' positions are indented with the thought.
const ACCUM_STYLE_PROPERTIES = ['marginLeft', 'paddingLeft']

/** Recursiveley calculates the tree of visible thoughts, in order, represented as a flat list of thoughts with tree layout information. */
const virtualTree = (
  state: State,
  {
    // Base path to start the traversal. Defaults to HOME_PATH.
    basePath,
    depth,
    env,
    indexDescendant,
    // ancestor styles that accmulate such as marginLeft are applied, merged, and passed to descendants
    styleAccum,
    // =grandparent styles must be passed separately since they skip a level
    styleFromGrandparent,
  }: {
    basePath?: SimplePath
    depth: number
    env?: LazyEnv
    indexDescendant: number
    styleAccum?: React.CSSProperties | null
    styleFromGrandparent?: React.CSSProperties | null
  } = {
    depth: 0,
    indexDescendant: 0,
  },
): TreeThought[] => {
  const simplePath = basePath || HOME_PATH
  const hashedPath = hashPath(simplePath)
  if (!isRoot(simplePath) && !state.expanded[hashedPath] && !state.expandHoverDownPaths[hashedPath]) return []

  const thoughtId = head(simplePath)
  const children = getAllChildrenSorted(state, thoughtId)
  const filteredChildren = children.filter(childrenFilterPredicate(state, simplePath))
  const childrenAttributeId = findDescendant(state, thoughtId, '=children')
  const grandchildrenAttributeId = findDescendant(state, thoughtId, '=grandchildren')
  const styleChildren = getStyle(state, childrenAttributeId)
  const style = safeRefMerge(styleAccum, styleChildren, styleFromGrandparent)

  const thoughts = filteredChildren.reduce<TreeThought[]>((accum, child, i) => {
    const childPath = appendToPathMemo(simplePath, child.id)
    const lastVirtualIndex = accum.length > 0 ? accum[accum.length - 1].indexDescendant : 0
    const virtualIndexNew = indexDescendant + lastVirtualIndex + (depth === 0 && i === 0 ? 0 : 1)
    const envParsed = parseLet(state, simplePath)
    const envNew =
      env && Object.keys(env).length > 0 && Object.keys(envParsed).length > 0 ? { ...env, ...envParsed } : undefined

    const descendants = virtualTree(state, {
      basePath: childPath,
      depth: depth + 1,
      env: envNew,
      indexDescendant: virtualIndexNew,
      // merge styleGrandchildren so it gets applied to this child's children
      styleAccum: safeRefMerge(
        styleAccum,
        _.pick(styleChildren, ACCUM_STYLE_PROPERTIES),
        _.pick(getStyle(state, grandchildrenAttributeId), ACCUM_STYLE_PROPERTIES),
      ),
      styleFromGrandparent: getStyle(state, grandchildrenAttributeId),
    })

    return [
      ...accum,
      {
        depth,
        env: envNew || undefined,
        indexChild: i,
        indexDescendant: virtualIndexNew,
        // true if the thought has no visible children.
        // It may still have hidden children.
        leaf: descendants.length === 0,
        simplePath: childPath,
        style,
        thought: child,
      },
      ...descendants,
    ]
  }, [])

  return thoughts
}

/** Lays out thoughts as DOM siblings with manual x,y positioning. */
const LayoutTree = () => {
  // Track dynamic thought heights from inner refs via VirtualThought. These are used to set the absolute y position which enables animation.
  const [heights, setHeights] = useState<Index<number>>({})
  const virtualThoughts = useSelector(virtualTree)
  const fontSize = useSelector((state: State) => state.fontSize)
  const indent = useSelector((state: State) =>
    state.cursor && state.cursor.length > 2
      ? // when the cursor is on a leaf, the indention level should not change
        state.cursor.length - (hasChildren(state, head(state.cursor)) ? 2 : 3)
      : 0,
  )

  // cursor depth, taking into account that a leaf cursor has the same autofocus depth as its parent
  const autofocusDepth = useSelector((state: State) => {
    // only set during drag-and-drop to avoid re-renders
    if ((!state.dragInProgress && !globals.simulateDrag && !globals.simulateDrop) || !state.cursor) return 0
    const isCursorLeaf = !hasChildren(state, head(state.cursor))
    return state.cursor.length + (isCursorLeaf ? -1 : 0)
  })

  // first uncle of the cursor used for DropBefore
  const cursorUncleId = useSelector((state: State) => {
    // only set during drag-and-drop to avoid re-renders
    if ((!state.dragInProgress && !globals.simulateDrag && !globals.simulateDrop) || !state.cursor) return null
    const isCursorLeaf = !hasChildren(state, head(state.cursor))
    const cursorParentId = state.cursor[state.cursor.length - (isCursorLeaf ? 3 : 2)] as ThoughtId | null
    return (cursorParentId && nextSibling(state, cursorParentId)?.id) || null
  })

  // setup list virtualization
  const viewport = viewportStore.useState()
  const overshoot = 5 // the number of additional thoughts below the bottom of the screen that are rendered
  const top = viewport.scrollTop + viewport.innerHeight + overshoot
  // The estimatedHeight calculation is ostensibly related to the font size, line height, and padding, though the process of determination was guess-and-check. This formula appears to work across font sizes.
  // If estimatedHeight is off, then totalHeight will fluctuate as actual heights are saved (due to estimatedHeight differing from the actual single-line height).
  const estimatedHeight = fontSize * 2 - 2

  // Sum all the heights to get the total height.
  // Use estimated single-line height for the thoughts that do not have heights yet.
  // Not sure why we need +1, but without it the totalHeight changes from list virtualization.
  const totalHeight =
    Object.values(heights).reduce((a, b) => a + b, 0) +
    (virtualThoughts.length - Object.values(heights).length) * estimatedHeight

  // accumulate the y position as we iterate the visible thoughts since the heights may vary
  let y = 0

  /** Update the height record of a single thought. This should be called whenever the size of a thought changes to ensure that y positions are updated accordingly and thoughts are animated into place. Otherwise, y positions will be out of sync and thoughts will start to overlap. */
  const updateHeight = (id: ThoughtId, height: number | null) =>
    setHeights(heightsOld => {
      // Delete height record when thought unmounts, otherwise heights will consume a non-decreasing amount of memory.
      if (!height && heightsOld[id]) {
        // eslint-disable-next-line fp/no-delete
        delete heightsOld[id]
      }
      return heightsOld[id] !== height
        ? {
            ...heightsOld,
            ...(height ? { [id]: height } : null),
          }
        : heightsOld
    })

  return (
    <div
      style={{
        // Set a minimum height that fits all thoughts based on their estimated height.
        // Otherwise scrolling down quickly will bottom out as the thoughts are re-rendered and the document height is built back up.
        height: totalHeight,
        // Use translateX instead of marginLeft to prevent multiline thoughts from continuously recalculating layout as their width changes during the transition.
        // The indent multipicand (0.9) causes the translateX counter-indentation to fall short of the actual indentation, causing a progressive shifting right as the user navigates deeper. This provides an additional cue for the user's depth, which is helpful when autofocus obscures the actual depth, but it must stay small otherwise the thought width becomes too small.
        transform: `translateX(${1.5 - indent * 0.9}em)`,
        transition: 'transform 0.75s ease-out',
        // Add a negative marginRight equal to translateX to ensure the thought takes up the full width. Not animated for a more stable visual experience.
        marginRight: `${-indent * 0.9 + (isTouch ? 2 : -1)}em`,
      }}
    >
      {virtualThoughts.map(({ depth, env, indexChild, indexDescendant, leaf, simplePath, style, thought }, i) => {
        const next = virtualThoughts[i + 1]
        const prev = virtualThoughts[i - 1]
        // cliff is the number of levels that drop off after the last thought at a given depth. Increase in depth is ignored.
        // This is used to determine how many DropEnd to insert before the next thought (one for each level dropped).
        const cliff = next ? Math.min(0, next.depth - depth) : -depth - 1

        const height = heights[thought.id] ? heights[thought.id] : estimatedHeight
        const thoughtY = y
        y += height

        // List Virtualization
        // Hide thoughts that are below the viewport.
        // Render virtualized thoughts with their estimated height so that documeent height is relatively stable.
        const isBelowViewport = thoughtY > top + height
        if (isBelowViewport) return null

        return (
          <React.Fragment key={thought.id}>
            <div
              aria-label='tree-node'
              style={{
                position: 'absolute',
                // Cannot use transform because it creates a new stacking context, which causes later siblings' SubthoughtsDropEmpty to be covered by previous siblings'.
                // Unfortunately left causes layout recalculation, so we may want to hoist SubthoughtsDropEmpty into a parent and manually control the position.
                left: `${depth}em`,
                top: thoughtY,
                transition: 'left 0.15s ease-out,top 0.15s ease-out',
                // If width is auto, it unintentionally animates as left animates and the text wraps.
                // Therefore, set the width so that is stepped and only changes with depth.
                width: `calc(100% - ${depth - 1}em)`,
                ...style,
              }}
            >
              <VirtualThought
                debugIndex={globals.simulateDrop ? indexChild : undefined}
                depth={depth}
                dropBefore={thought.id === cursorUncleId}
                env={env}
                indexDescendant={indexDescendant}
                // isMultiColumnTable={isMultiColumnTable}
                isMultiColumnTable={false}
                leaf={leaf}
                nextChildId={next?.depth < depth ? next?.thought.id : undefined}
                onResize={updateHeight}
                prevChildId={indexChild !== 0 ? prev?.thought.id : undefined}
                simplePath={simplePath}
              />

              {/* DropEnd (cliff) */}
              {cliff < 0 &&
                // do not render hidden cliffs
                // rough autofocus estimate
                autofocusDepth - depth < 2 &&
                Array(-cliff)
                  .fill(0)
                  .map((x, i) => {
                    const simplePathEnd =
                      -(cliff + i) < simplePath.length ? (simplePath.slice(0, cliff + i) as SimplePath) : HOME_PATH
                    const cliffDepth = unroot(simplePathEnd).length
                    return (
                      <div
                        key={`${head(simplePathEnd)}`}
                        className='z-index-subthoughts-drop-end'
                        style={{
                          position: 'relative',
                          top: '-0.2em',
                          left: `calc(${cliffDepth - depth}em + ${isTouch ? -1 : 1}px)`,
                          transition: 'left 0.15s ease-out',
                        }}
                      >
                        <DropEnd
                          depth={simplePathEnd.length}
                          indexDescendant={indexDescendant}
                          leaf={false}
                          simplePath={simplePathEnd}
                          // Extend the click area of the drop target when there is nothing below.
                          // The last visible drop-end will always be a dimmed thought at distance 1 (an uncle).
                          // Dimmed thoughts at distance 0 should not be extended, as they are dimmed siblings and sibling descendants that have thoughts below
                          // last={!nextChildId}
                        />
                      </div>
                    )
                  })}
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default LayoutTree
