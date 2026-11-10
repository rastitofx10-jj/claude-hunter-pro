---
name: elite-dna-hunter-orchestrator
description: Autonomous intelligence system that discovers, mines, and curates premium Claude project DNA with industrial-grade precision, quality gates, and adaptive learning.
---

# Elite DNA Hunter Orchestrator

## Overview
Master orchestrator for the full lifecycle of discovering, extracting, validating, and curating premium Claude project DNA. Combines autonomous intelligence with rigorous quality gates and adaptive learning to build an industrial-grade DNA library with minimal noise.

## Core Architecture
### Three-Zone Model
- **System Zone (`.claude/`)**: Read-only configuration and protocols
- **State Zone (`grimoires/`, `.beads/`)**: Read-write for DNA artifacts and learning records
- **App Zone (`src/`, `lib/`, etc.)**: Read-only for target project analysis

## Activation Triggers
Use when:
- Starting a new DNA mining operation
- Validating extracted DNA quality
- Curating the DNA library
- Analyzing mining performance
- Updating extraction strategies

## Workflow

### Phase 1: Target Discovery
```bash
# Discover premium Claude projects
node .claude/hunter/bin/discover.mjs --json --min-stars 100 --claudium-score >
  grimoires/loa/targets/discovery-$(date +%Y%m%d).json
```

### Phase 2: DNA Extraction
```bash
# Extract DNA from verified targets
node .claude/hunter/bin/extract.mjs --json --target <target-repo> --depth 3 >
  grimoires/loa/dna/raw/<repo-slug>-$(date +%Y%m%d).json
```

### Phase 3: Quality Validation
```bash
# Validate extracted DNA against quality gates
node .claude/hunter/bin/validate.mjs --json --input <dna-file> --schema dna-schema.json >
  grimoires/loa/dna/validated/<repo-slug>-$(date +%Y%m%d).json
```

### Phase 4: Curation
```bash
# Curate validated DNA into the library
node .claude/hunter/bin/curate.mjs --json --input <validated-dna> --category <category> >
  grimoires/loa/library/curated/<category>-$(date +%Y%m%d).json
```

## Quality Gates
### DNA Validation Criteria
1. **Source Authenticity**: Verify repository contains actual Claude project files
2. **Quality Score**: Minimum 0.8/1.0 on DNA quality metrics
3. **Completeness**: All required artifact types present
4. **Uniqueness**: Significant novel DNA not already in library
5. **Relevance**: Matches target categories of interest

### Validation Artifacts
- **DNA Manifest**: `dna/manifest.json` - Summary of extracted artifacts
- **Quality Report**: `dna/validation.json` - Quality metrics and failures
- **Provenance Record**: `dna/provenance.json` - Source attribution and extraction metadata

## Adaptive Learning
### Performance Analysis
```bash
# Analyze mining performance
node .claude/hunter/bin/analyze.mjs --json --since <date> >
  grimoires/loa/analytics/performance-$(date +%Y%m%d).json
```

### Strategy Updates
Based on performance analysis, automatically:
1. Adjust target selection criteria
2. Refine extraction depth parameters
3. Update validation thresholds
4. Prioritize high-value categories

## DNA Library Structure
```
grimoires/loa/library/
  ├── curated/
  │   ├── skills/
  │   ├── commands/
  │   ├── agents/
  │   └── patterns/
  ├── raw/
  ├── validated/
  └── index.json
```

## Configuration
Required environment variables:
- `GITHUB_TOKEN`: GitHub API access
- `CLAUDE_API_KEY`: Claude API for validation
- `MIN_STARS`: Minimum star threshold (default: 100)
- `MAX_DEPTH`: Extraction depth (default: 3)
- `QUALITY_THRESHOLD`: Minimum quality score (default: 0.8)

## Error Handling
- **Extraction Failures**: Log to `grimoires/loa/errors/` with detailed diagnostics
- **Validation Rejections**: Create `dna/rejected/` with rejection reasons
- **System Errors**: Halt with clear error messages and recovery steps

## Output Artifacts
Each successful operation produces:
1. **DNA Package**: Complete extracted and validated DNA
2. **Quality Certificate**: Validation results and scores
3. **Provenance Record**: Source attribution and extraction metadata
4. **Learning Signal**: Performance data for strategy adaptation