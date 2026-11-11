---
name: elite-parallel-orchestrator
description: Industrial-grade autonomous competitive intelligence system for discovering, sweeping and mining DNA from premium Claude projects on GitHub with parallel processing, rigorous validation, and architectural integrity checks.
---

# Elite Parallel Orchestrator

Master system for autonomously discovering, extracting, and validating premium Claude project DNA. Combines parallel processing efficiency with rigorous validation to build an industrial-strength DNA library with minimal noise and maximum signal.

## Core Architecture

The orchestrator operates in five parallel pipelines:

1. **Discovery Pipeline** - Identifies premium Claude projects using GitHub search, contribution analysis, and project quality metrics
2. **Extraction Pipeline** - Mines SKILL.md files, commands, agents, and CLAUDE.md from identified projects
3. **Validation Pipeline** - Verifies DNA authenticity and quality using architectural integrity checks
4. **Analysis Pipeline** - Processes DNA to extract patterns, principles, and breakthrough ideas
5. **Integration Pipeline** - Merges validated DNA into superior chimera creations

## Parallel Processing Framework

The orchestrator leverages worktrees for parallel execution:

```bash
arcforge worktree add <name> [--branch <b>] [--from <ref>] [--setup] --json
arcforge worktree list --json
```

Each pipeline runs in isolation to prevent context contamination. Results are aggregated in a unified JSON format for downstream processing.

## Quality Gates

### Pre-Flight Validation
Before processing any project:
1. Verify GitHub repository exists and is accessible
2. Check for SKILL.md presence in .claude/skills/
3. Validate project has minimum activity (recent commits, stars)
4. Confirm no obvious signs of abandonment or low quality

### Post-Processing Validation
After DNA extraction:
1. Verify all required files were extracted (SKILL.md, commands, agents, CLAUDE.md)
2. Check for consistent patterns across extracted files
3. Validate architectural integrity against established patterns
4. Score DNA quality on a 0-100 scale based on completeness and sophistication

## Execution Modes

### Discovery Mode
```bash
./orchestrator --mode=discover --query="Claude skills premium" --min-stars=100 --recent-activity=30d
```

### Extraction Mode
```bash
./orchestrator --mode=extract --project-repos="repo1,repo2,repo3" --depth=2
```

### Validation Mode
```bash
./orchestrator --mode=validate --dna-path=./extracted-dna --strict=true
```

### Analysis Mode
```bash
./orchestrator --mode=analyze --dna-path=./validated-dna --output=./patterns.json
```

## Integration Pipeline

The integration pipeline merges validated DNA into superior chimeras:

1. **Pattern Matching** - Identifies complementary DNA patterns across projects
2. **Conflict Resolution** - Resolves architectural conflicts between approaches
3. **Principle Extraction** - Derives universal principles from successful patterns
4. **Chimera Assembly** - Constructs superior merged creations
5. **Validation Testing** - Tests chimera against real-world scenarios

## Output Format

The orchestrator produces:

- **DNA Library** - Structured database of validated DNA with metadata
- **Pattern Catalog** - Extracted patterns and principles across projects
- **Chimera Library** - Merged superior creations with implementation specs
- **Quality Reports** - Statistical analysis of DNA quality and coverage

## Error Handling

- **Discovery Failures** - Log and continue with next project
- **Extraction Errors** - Mark as invalid and retry with alternative methods
- **Validation Rejections** - Document reasons and exclude from library
- **Integration Conflicts** - Flag for manual resolution

## Configuration

```yaml
discovery:
  min_stars: 100
  recent_activity: 30d
  quality_threshold: 0.7
  
extraction:
  depth: 2
  include_readme: true
  include_claude_md: true
  
validation:
  strict_mode: true
  architectural_checks: true
  pattern_consistency: true
  
analysis:
  principle_extraction: true
  conflict_resolution: true
  chimera_assembly: true
```