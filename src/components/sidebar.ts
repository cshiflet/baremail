import { h } from 'preact';
import { useMemo, useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import type { GmailLabel } from '../types.js';

const html = htm.bind(h);

interface LabelTreeNode {
  segment: string;
  fullPath: string;
  label?: GmailLabel;
  children: LabelTreeNode[];
}

function buildTree(labels: GmailLabel[]): LabelTreeNode[] {
  const roots: LabelTreeNode[] = [];
  const nodeMap = new Map<string, LabelTreeNode>();

  for (const label of labels) {
    const parts = label.name.split('/');
    let parentPath = '';
    let parentNode: LabelTreeNode | null = null;
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
      let node = nodeMap.get(fullPath);
      if (!node) {
        node = { segment, fullPath, children: [] };
        nodeMap.set(fullPath, node);
        if (parentNode) parentNode.children.push(node);
        else roots.push(node);
      }
      if (i === parts.length - 1) node.label = label;
      parentNode = node;
      parentPath = fullPath;
    }
  }

  const sortRecursive = (nodes: LabelTreeNode[]) => {
    nodes.sort((a, b) => a.segment.localeCompare(b.segment));
    for (const n of nodes) sortRecursive(n.children);
  };
  sortRecursive(roots);

  return roots;
}

function collectInternalPaths(nodes: LabelTreeNode[], out: Set<string>): void {
  for (const n of nodes) {
    if (n.children.length > 0) {
      out.add(n.fullPath);
      collectInternalPaths(n.children, out);
    }
  }
}

interface SidebarProps {
  labels: GmailLabel[];
  activeLabel: string;
  useGmailLabelColors: boolean;
  onLabelClick: (labelId: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ labels, activeLabel, useGmailLabelColors, onLabelClick, isOpen, onClose }: SidebarProps) {
  const userLabels = useMemo(() => labels.filter(l => l.type === 'user'), [labels]);
  const tree = useMemo(() => buildTree(userLabels), [userLabels]);

  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (collapsed === null && tree.length > 0) {
      const init = new Set<string>();
      collectInternalPaths(tree, init);
      setCollapsed(init);
    }
  }, [tree, collapsed]);

  if (userLabels.length === 0) return null;

  const effectiveCollapsed = collapsed ?? new Set<string>();

  const toggle = (path: string) => {
    setCollapsed(prev => {
      const base = prev ?? new Set<string>();
      const next = new Set(base);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => {
    const all = new Set<string>();
    collectInternalPaths(tree, all);
    setCollapsed(all);
  };

  const renderNode = (node: LabelTreeNode, depth: number): any => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = effectiveCollapsed.has(node.fullPath);
    const labelId = node.label?.id;
    const isActive = labelId !== undefined && labelId === activeLabel;
    const useColor = useGmailLabelColors && node.label?.color;
    const labelStyle = useColor
      ? `color: ${node.label!.color!.textColor || 'inherit'}; background: ${node.label!.color!.backgroundColor || 'transparent'};`
      : '';
    const indentPx = depth * 12;

    return html`
      <div key=${node.fullPath} class="sidebar-node">
        <div class="sidebar-node-row" style="padding-left: ${indentPx + 8}px;">
          ${hasChildren
            ? html`<button class="sidebar-collapse-btn" onClick=${() => toggle(node.fullPath)} title=${isCollapsed ? 'expand' : 'collapse'}>${isCollapsed ? '▸' : '▾'}</button>`
            : html`<span class="sidebar-collapse-spacer" />`
          }
          ${labelId
            ? html`
              <button
                class="sidebar-label ${isActive ? 'active' : ''}"
                style=${labelStyle}
                onClick=${() => { onLabelClick(labelId); onClose(); }}
                title=${node.label!.name}
              >
                <span class="sidebar-label-name">${node.segment}</span>
                ${node.label!.messagesUnread ? html`<span class="sidebar-label-count">${node.label!.messagesUnread}</span>` : ''}
              </button>
            `
            : html`
              <span class="sidebar-label sidebar-label-virtual" title=${node.fullPath}>
                <span class="sidebar-label-name">${node.segment}</span>
              </span>
            `
          }
        </div>
        ${hasChildren && !isCollapsed && html`
          <div class="sidebar-children">
            ${node.children.map(c => renderNode(c, depth + 1))}
          </div>
        `}
      </div>
    `;
  };

  return html`
    <aside class="sidebar ${isOpen ? 'open' : ''}">
      <div class="sidebar-header">
        <span class="sidebar-header-title">labels</span>
        <span class="sidebar-header-actions">
          <button class="sidebar-header-btn" onClick=${expandAll} title="expand all">[+]</button>
          <button class="sidebar-header-btn" onClick=${collapseAll} title="collapse all">[−]</button>
        </span>
      </div>
      <div class="sidebar-list">
        ${tree.map(node => renderNode(node, 0))}
      </div>
    </aside>
  `;
}
