<#
.SYNOPSIS
    Update all project dependencies (npm and Cargo)
.DESCRIPTION
    Updates JavaScript/TypeScript dependencies via npm and Rust dependencies via cargo
    Provides both interactive and automatic modes
#>

param(
    [switch]$Auto,
    [switch]$SkipNpm,
    [switch]$SkipCargo
)

$ErrorActionPreference = "Stop"

# --- AUTO-DETECT PROJECT ROOT ---
if ($PSScriptRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
    Set-Location $ProjectRoot
}
else {
    $ProjectRoot = Get-Location
}

Write-Host "Working Directory: $ProjectRoot" -ForegroundColor Cyan
Write-Host ""

# --- NPM UPDATES ---
if (-not $SkipNpm) {
    Write-Host "JavaScript/TypeScript Dependencies" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor DarkGray
    
    if ($Auto) {
        Write-Host "Running automatic npm update..." -ForegroundColor Cyan
        npm update
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] npm dependencies updated" -ForegroundColor Green
        }
        else {
            Write-Host "[ERROR] npm update failed" -ForegroundColor Red
        }
    }
    else {
        Write-Host "Checking for outdated npm packages..." -ForegroundColor Cyan
        npm outdated
        Write-Host ""
        
        $Response = Read-Host "Update npm dependencies? (Y/n)"
        if ($Response -eq "" -or $Response -eq "Y" -or $Response -eq "y") {
            Write-Host "Updating npm packages..." -ForegroundColor Cyan
            npm update
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[OK] npm dependencies updated" -ForegroundColor Green
            }
            else {
                Write-Host "[ERROR] npm update failed" -ForegroundColor Red
            }
        }
        else {
            Write-Host "[SKIP] Skipped npm updates" -ForegroundColor Yellow
        }
    }
    Write-Host ""
}

# --- CARGO UPDATES ---
if (-not $SkipCargo) {
    Write-Host "Rust Dependencies" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor DarkGray
    
    $CargoPath = "src-tauri"
    
    # Check if cargo-update is installed
    $CargoUpdateInstalled = cargo install --list | Select-String "cargo-update"
    
    if (-not $CargoUpdateInstalled) {
        Write-Host "cargo-update not found. Installing..." -ForegroundColor Cyan
        cargo install cargo-update
        Write-Host ""
    }
    
    if ($Auto) {
        Write-Host "Running automatic cargo update..." -ForegroundColor Cyan
        Push-Location $CargoPath
        cargo update
        Pop-Location
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Cargo dependencies updated" -ForegroundColor Green
        }
        else {
            Write-Host "[ERROR] Cargo update failed" -ForegroundColor Red
        }
    }
    else {
        Write-Host "Checking for outdated cargo packages..." -ForegroundColor Cyan
        Push-Location $CargoPath
        cargo outdated
        Pop-Location
        Write-Host ""
        
        $Response = Read-Host "Update cargo dependencies? (Y/n)"
        if ($Response -eq "" -or $Response -eq "Y" -or $Response -eq "y") {
            Write-Host "Updating cargo packages..." -ForegroundColor Cyan
            Push-Location $CargoPath
            cargo update
            Pop-Location
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[OK] Cargo dependencies updated" -ForegroundColor Green
            }
            else {
                Write-Host "[ERROR] Cargo update failed" -ForegroundColor Red
            }
        }
        else {
            Write-Host "[SKIP] Skipped cargo updates" -ForegroundColor Yellow
        }
    }
    Write-Host ""
}

# --- SUMMARY ---
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host "Dependency update process complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Tips:" -ForegroundColor Cyan
Write-Host "  - Run tests after updating dependencies" -ForegroundColor Gray
Write-Host "  - Check CHANGELOG for breaking changes" -ForegroundColor Gray
Write-Host "  - Commit lock file changes" -ForegroundColor Gray
Write-Host ""
