package com.molly.parent

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Jasmine = Color(0xFFF8DE7E)
val Leaf = Color(0xFF3B6350)
private val LightColors = lightColorScheme(
    primary = Jasmine, onPrimary = Color(0xFF302C20), primaryContainer = Color(0xFFF3E8BB), onPrimaryContainer = Color(0xFF40391F),
    secondary = Leaf, onSecondary = Color.White, secondaryContainer = Color(0xFFE0EADF), onSecondaryContainer = Color(0xFF284936),
    tertiary = Color(0xFF38475C),
    background = Color(0xFFF4F2E9), onBackground = Color(0xFF2B2D28),
    surface = Color(0xFFFBFAF5), onSurface = Color(0xFF2B2D28),
    surfaceVariant = Color(0xFFEAE7DB), onSurfaceVariant = Color(0xFF65645C),
    surfaceContainer = Color(0xFFFBFAF5), surfaceContainerLow = Color(0xFFFBFAF5),
    surfaceContainerHigh = Color(0xFFEAE7DB), surfaceContainerHighest = Color(0xFFEAE7DB),
    outline = Color(0xFF848176), outlineVariant = Color(0xFFDDD9CC), error = Color(0xFFAC342F)
)
private val DarkColors = darkColorScheme(
    primary = Jasmine, onPrimary = Color(0xFF302C20), primaryContainer = Color(0xFF51462A), onPrimaryContainer = Jasmine,
    secondary = Color(0xFFAACCB6), onSecondary = Color(0xFF173D2A), secondaryContainer = Color(0xFF334D3C), onSecondaryContainer = Color(0xFFD3E9D9),
    background = Color(0xFF211F1B), onBackground = Color(0xFFF1EEE3),
    surface = Color(0xFF2D2A24), onSurface = Color(0xFFF1EEE3),
    surfaceVariant = Color(0xFF38342D), onSurfaceVariant = Color(0xFFC3BFB3),
    surfaceContainer = Color(0xFF2D2A24), surfaceContainerLow = Color(0xFF2D2A24),
    surfaceContainerHigh = Color(0xFF38342D), surfaceContainerHighest = Color(0xFF38342D),
    outline = Color(0xFF979184), outlineVariant = Color(0xFF4B463C), error = Color(0xFFFFB4AB)
)
private val MollyTypography = Typography(
    headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 42.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 27.sp, lineHeight = 36.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 30.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 25.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 25.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 22.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 18.sp)
)
@Composable fun MollyTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        typography = MollyTypography,
        shapes = Shapes(extraSmall = RoundedCornerShape(8.dp), small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(20.dp), large = RoundedCornerShape(24.dp), extraLarge = RoundedCornerShape(32.dp)), content = content)
}
