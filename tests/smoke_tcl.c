#include <stdio.h>
#include <tcl.h>

int main(void) {
    Tcl_FindExecutable("/smoke");
    Tcl_Interp *interp = Tcl_CreateInterp();
    if (!interp) {
        fprintf(stderr, "Tcl_CreateInterp returned NULL\n");
        return 1;
    }
    if (Tcl_Eval(interp, "expr {2 + 3}") != TCL_OK) {
        fprintf(stderr, "Tcl_Eval failed: %s\n", Tcl_GetStringResult(interp));
        Tcl_DeleteInterp(interp);
        return 1;
    }
    printf("2 + 3 = %s\n", Tcl_GetStringResult(interp));
    if (Tcl_Eval(interp, "string length \"hello world\"") != TCL_OK) {
        fprintf(stderr, "string-length eval failed\n");
        Tcl_DeleteInterp(interp);
        return 1;
    }
    printf("strlen(\"hello world\") = %s\n", Tcl_GetStringResult(interp));
    Tcl_DeleteInterp(interp);
    printf("smoke ok\n");
    return 0;
}
