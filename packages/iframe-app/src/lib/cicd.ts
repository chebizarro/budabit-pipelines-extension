import yaml from 'js-yaml'

export interface ActStep {
  name: string
  status: 'success' | 'failure' | 'pending'
  logs: string[]
  durationMs?: number
}

export interface ActJob {
  name: string
  status: 'success' | 'failure' | 'pending'
  steps: ActStep[]
  durationMs?: number
}

export interface WorkflowStep {
  name: string
  uses?: string
  run?: string
}

export interface WorkflowJob {
  id: string
  name: string
  runsOn: string
  needs: string[]
  steps: WorkflowStep[]
}

export interface JobGroup {
  jobs: WorkflowJob[]
}

export interface MatrixGroup {
  baseName: string
  variants: {label: string; actJob: ActJob}[]
}

function normalizeJobName(raw: string): string {
  return raw.trim().replace(/-\d+$/, '')
}

function parseActDuration(text: string): number | undefined {
  const match = text.match(/\[(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)\]/)
  if (!match) return undefined
  const minutesText = match[1] || '0'
  const valueText = match[2] || '0'
  const unit = match[3] || 's'
  const minutes = Number.parseInt(minutesText, 10)
  const value = Number.parseFloat(valueText)
  if (unit === 'ms') return Math.round(minutes * 60000 + value)
  return Math.round((minutes * 60 + value) * 1000)
}

export function parseActLog(log: string): ActJob[] {
  const jobMap = new Map<string, ActJob>()
  const currentStep = new Map<string, ActStep>()

  for (const line of log.split('\n')) {
    const match = line.match(/^\[([^\]\/]+)\/([^\]]+)\]\s(.*)$/)
    if (!match) continue

    const jobName = normalizeJobName(match[2] || '')
    const content = match[3] || ''

    if (!jobMap.has(jobName)) {
      jobMap.set(jobName, {name: jobName, status: 'pending', steps: []})
    }

    const job = jobMap.get(jobName)!

    if (content.includes('⭐ Run ')) {
      const stepName = content.slice(content.indexOf('⭐ Run ') + '⭐ Run '.length).trim()
      const step: ActStep = {name: stepName, status: 'pending', logs: []}
      job.steps.push(step)
      currentStep.set(jobName, step)
    } else if (/^\s+\| /.test(content)) {
      currentStep.get(jobName)?.logs.push(content.replace(/^\s+\| /, ''))
    } else if (content.includes('✅') && content.includes('Success')) {
      const step = currentStep.get(jobName)
      if (step) {
        step.status = 'success'
        step.durationMs = parseActDuration(content)
      }
    } else if (content.includes('❌') && content.includes('Failure')) {
      const step = currentStep.get(jobName)
      if (step) {
        step.status = 'failure'
        step.durationMs = parseActDuration(content)
      }
      job.status = 'failure'
    } else if (content.includes('🏁')) {
      if (content.includes('succeeded')) {
        if (job.status !== 'failure') job.status = 'success'
      } else {
        job.status = 'failure'
      }
    }
  }

  for (const job of jobMap.values()) {
    const total = job.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
    if (total > 0) job.durationMs = total
  }

  return Array.from(jobMap.values())
}

export function groupMatrixJobs(jobs: ActJob[]): MatrixGroup[] {
  const groupMap = new Map<string, {label: string; actJob: ActJob}[]>()
  const groupOrder: string[] = []

  for (const job of jobs) {
    const match = job.name.match(/^(.+?)\s*\(([^)]+)\)$/)
    const baseName = match?.[1]?.trim() || job.name
    const variantLabel = match?.[2] || ''

    if (!groupMap.has(baseName)) {
      groupMap.set(baseName, [])
      groupOrder.push(baseName)
    }

    groupMap.get(baseName)!.push({label: variantLabel, actJob: job})
  }

  return groupOrder.map(baseName => ({
    baseName,
    variants: groupMap.get(baseName) || [],
  }))
}

export function getJobGroups(jobs: WorkflowJob[]): JobGroup[] {
  if (jobs.length === 0) return []

  const assigned = new Set<string>()
  const groups: JobGroup[] = []

  while (assigned.size < jobs.length) {
    const group: WorkflowJob[] = []

    for (const job of jobs) {
      if (assigned.has(job.id)) continue
      if (job.needs.every(need => assigned.has(need))) {
        group.push(job)
      }
    }

    if (group.length === 0) {
      groups.push({jobs: jobs.filter(job => !assigned.has(job.id))})
      break
    }

    group.forEach(job => assigned.add(job.id))
    groups.push({jobs: group})
  }

  return groups
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) return value
  return value === undefined ? [] : [value]
}

export function parseWorkflowJobsFromYaml(content: string): WorkflowJob[] {
  const doc = yaml.load(content) as any
  const jobs = doc?.jobs
  if (!jobs || typeof jobs !== 'object') return []

  return Object.entries(jobs).map(([id, rawJob]) => {
    const job = rawJob as any
    const rawSteps = Array.isArray(job?.steps) ? job.steps : []
    const rawNeeds = asArray<string>(job?.needs).filter(Boolean)
    const runsOn = Array.isArray(job?.['runs-on'])
      ? job['runs-on'].join(', ')
      : typeof job?.['runs-on'] === 'string'
        ? job['runs-on']
        : ''

    return {
      id: String(id),
      name: typeof job?.name === 'string' && job.name.trim().length > 0 ? job.name : String(id),
      runsOn,
      needs: rawNeeds,
      steps: rawSteps.map((step: any, index: number) => ({
        name:
          typeof step?.name === 'string' && step.name.trim().length > 0
            ? step.name
            : step?.uses || step?.run?.split('\n')[0] || `Step ${index + 1}`,
        uses: typeof step?.uses === 'string' ? step.uses : undefined,
        run: typeof step?.run === 'string' ? step.run : undefined,
      })),
    }
  })
}
