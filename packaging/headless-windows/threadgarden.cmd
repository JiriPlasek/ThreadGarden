@echo off
"%~dp0..\node\node.exe" --disable-warning=ExperimentalWarning "%~dp0..\current\lib\service.mjs" %*
